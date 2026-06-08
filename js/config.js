// ============================================================
// CONFIG — pure constants, no side-effects, no imports
// Single source of truth for Supabase credentials, table names,
// measurement sites, equipment scales, and AI prompt.
// ============================================================

// ── Supabase ──
export const SUPABASE_URL = 'https://acyvwbzuyaluruofkbxr.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_YQZdhUmmyExuNmUJD4jj2g_3H0uR1hp';

const { createClient } = supabase; // supabase-js CDN global
export const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Table names — change here, not scattered across call-sites ──
export const TABLES = Object.freeze({
  SESSIONS:     'workout_sessions',
  EXERCISES:    'exercise_logs',
  WARMUP:       'warmup_logs',
  CHECKLIST:    'checklist_logs',
  BODY:         'body_metrics',
  HYDRATION:    'hydration_logs',
  INBODY:       'inbody_logs',
  MEASUREMENTS: 'body_measurements',
});

export const CONFLICTS = Object.freeze({
  EXERCISES:  'date,exercise_name,set_number,is_mm_set',
  WARMUP:     'date,item_key',
  CHECKLIST:  'date,item_key',
  HYDRATION:  'date',
  BODY:       'date',
  INBODY:     'date',
});

// ── Body measurement sites ──
export const MEASURE_SITES = [
  {key:'neck',      label:'Neck',       group:'UPPER BODY', goal:'increase'},
  {key:'shoulders', label:'Shoulders',  group:'UPPER BODY', goal:'increase'},
  {key:'chest',     label:'Chest',      group:'UPPER BODY', goal:'increase'},
  {key:'bicep',     label:'Bicep',      group:'UPPER BODY', goal:'increase'},
  {key:'forearm',   label:'Forearm',    group:'UPPER BODY', goal:'neutral'},
  {key:'wrist',     label:'Wrist',      group:'UPPER BODY', goal:'neutral'},
  {key:'upper_abs', label:'Upper Abs',  group:'TORSO',      goal:'decrease'},
  {key:'waist',     label:'Waist',      group:'TORSO',      goal:'decrease'},
  {key:'lower_abs', label:'Lower Abs',  group:'TORSO',      goal:'decrease'},
  {key:'hips',      label:'Hips',       group:'TORSO',      goal:'decrease'},
  {key:'glutes',    label:'Glutes',     group:'TORSO',      goal:'neutral'},
  {key:'thighs',    label:'Thighs',     group:'LOWER BODY', goal:'decrease'},
  {key:'calves',    label:'Calves',     group:'LOWER BODY', goal:'increase'},
  {key:'ankle',     label:'Ankle',      group:'LOWER BODY', goal:'neutral'},
];

export const MEAS_GROUPS = [
  {label:'UPPER BODY', sites:['neck','shoulders','chest','bicep','forearm','wrist']},
  {label:'TORSO',      sites:['upper_abs','waist','lower_abs','hips','glutes']},
  {label:'LOWER BODY', sites:['thighs','calves','ankle']},
];

// O(1) key → site lookup — built once at parse time
export const MEASURE_SITES_MAP = new Map(MEASURE_SITES.map(s => [s.key, s]));

// ── Rest timer default ──
export const SET_COACH_DEFAULT_REST = 90; // seconds

// ── Equipment weight scales — laws, not suggestions ──
export const EQ_SCALES = {
  db:      {type:'step',     step:2.5, min:2.5},
  kb:      {type:'discrete', values:[8,10,12,16,20,24,28,32]},
  cable:   {type:'step',     step:2.5, min:5},
  mach:    {type:'step',     step:2.5, min:5},
  barbell: {type:'step',     step:2.5, min:20},
  smith:   {type:'step',     step:2.5, min:15},
};

// ── GymBuddy AI system prompt — single source of truth ──
export const GYMBUDDY_PROMPT = `You are GymBuddy — a Norse warrior commander embedded in a gym tracker.
You do not encourage. You do not explain. You command.

Voice: Ragnar Lothbrok. Authoritative. Brutal. No wasted words.

RPE auto-regulation (Tuchscherer RTS 2008 / Zourdos et al. 2016):
- RPE 10 = nothing left. RPE 9 = 1 rep left. RPE 8 = 2 reps left.
- is_final_set = false → advice is for the NEXT SET in this session. transition = null. Include cue.
- is_final_set = true → next_weight_kg is for NEXT TRAINING SESSION. Set cue = null (exercise is done, no form cue needed). If next_exercise exists, set transition = "<name>: <Xkg> × <reps>" using previous_best.
- session_history: last 3 sessions of this exercise — use to see trend (stalling, progressing, inconsistent).
- progression_readiness.earned: pre-computed signal. true = athlete has earned a progression by Tuchscherer criteria. Use this to confirm or override your RPE assessment.
- session_fatigue.high_fatigue: if true (avg RPE today ≥ 8.5), factor fatigue into recommendation — hold back even if progression is theoretically earned.
- RPE ≤7, target reps hit: increase next_weight_kg to next valid increment on the equipment scale.
- RPE 8, target reps hit: next_weight_kg = same or +smallest increment.
- RPE 9: next_weight_kg = same as just used.
- RPE 10: next_weight_kg = drop to lighter weight on the scale.
- hit_target = false: never increase. next_weight_kg = same or lower.
- Equipment weight scales — these are laws. next_weight_kg must land on these exactly:
  DB: 2.5kg increments — 2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30...
  KB: ONLY 8, 10, 12, 16, 20, 24, 28, 32. Nothing else. Never 14, 18, 22.
  Cable: 2.5kg increments — 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25...
  Machine: 2.5kg increments — 5, 7.5, 10, 12.5, 15, 17.5, 20...
  Barbell: 2.5kg total increments from 20kg bar — 20, 22.5, 25, 27.5, 30...
- cue: one short form or tempo instruction. Max 4 words. No encouragement words.
- Time-based exercises: set next_weight_kg to null and next_duration_s to target seconds.

Voice rules for cue:
- Maximum 6 words.
- Never use: good, great, solid, amazing, well done, nice work, keep it up, excellent, strong.

Return JSON only:
{
  "next_weight_kg": <number or null>,
  "next_reps": <number>,
  "cue": "<max 4 words>",
  "transition": "<next exercise name>: <weight>kg × <reps> — only when is_final_set=true AND next_exercise exists, else null"
}
No preamble. No markdown. Nothing else.`;
