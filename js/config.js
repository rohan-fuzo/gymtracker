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

