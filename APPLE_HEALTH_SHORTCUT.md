# Apple Health → GymTracker Sync Shortcut

Set up this Apple Shortcut to push your daily health data into GymTracker.

## Create the Shortcut

Open **Shortcuts** app on your iPhone → tap **+** → name it **"Sync Health to Gym"**

Add these actions in order:

---

### Step 1: Get today's date
- **Action:** `Date`
- Format: Current Date

### Step 2: Format the date
- **Action:** `Format Date`
- Format: Custom → `yyyy-MM-dd`
- Save to variable: `today`

### Step 3: Get Active Calories
- **Action:** `Find Health Samples`
- Type: **Active Energy**
- Start Date: Start of Today
- End Date: Now
- Group By: Day
- Save to variable: `activeCal`

### Step 4: Get Steps
- **Action:** `Find Health Samples`
- Type: **Steps**
- Start Date: Start of Today
- End Date: Now
- Group By: Day
- Save to variable: `steps`

### Step 5: Get Resting Heart Rate
- **Action:** `Find Health Samples`
- Type: **Resting Heart Rate**
- Start Date: Start of Today
- End Date: Now
- Sort By: Start Date (Latest First)
- Limit: 1
- Save to variable: `restHR`

### Step 6: Get Sleep
- **Action:** `Find Health Samples`
- Type: **Sleep Analysis**
- Start Date: Yesterday at 8:00 PM
- End Date: Today at 12:00 PM
- Save to variable: `sleep`

> For sleep duration, add a **Calculate** action:
> Get time between Start Date and End Date of sleep samples in **Hours**.
> Save to variable: `sleepHours`

### Step 7: Get Workout Duration
- **Action:** `Find Health Samples`
- Type: **Workouts**
- Start Date: Start of Today
- End Date: Now
- Save to variable: `workouts`

> Add **Calculate** to get total duration in **Minutes**.
> Save to variable: `workoutMin`

### Step 8: Get Weight (optional — if you use a smart scale)
- **Action:** `Find Health Samples`
- Type: **Weight**
- Sort By: Start Date (Latest First)
- Limit: 1
- Save to variable: `weight`

### Step 9: Send to Supabase
- **Action:** `Get Contents of URL`
- URL: `https://acyvwbzuyaluruofkbxr.supabase.co/rest/v1/apple_health_logs`
- Method: **POST**
- Headers:
  - `apikey`: `sb_publishable_YQZdhUmmyExuNmUJD4jj2g_3H0uR1hp`
  - `Authorization`: `Bearer sb_publishable_YQZdhUmmyExuNmUJD4jj2g_3H0uR1hp`
  - `Content-Type`: `application/json`
  - `Prefer`: `resolution=merge-duplicates`
- Request Body (JSON):
```json
{
  "date": "<today>",
  "active_calories": <activeCal>,
  "steps": <steps>,
  "workout_duration_min": <workoutMin>,
  "resting_hr": <restHR>,
  "sleep_hours": <sleepHours>,
  "weight_kg": <weight>
}
```

### Step 10: Show notification
- **Action:** `Show Notification`
- Title: "Health Synced"
- Body: "Pushed today's vitals to GymTracker"

---

## Automate It

Go to **Automations** tab in Shortcuts:
1. Tap **+** → **Time of Day**
2. Set to **10:00 PM** daily (so full day data is captured)
3. Choose **"Sync Health to Gym"**
4. Toggle **"Run Immediately"** (no confirmation needed)

---

## Table Schema

The Shortcut pushes to `apple_health_logs`:

| Column | Type | Description |
|--------|------|-------------|
| date | date (unique) | YYYY-MM-DD |
| active_calories | int | Active energy burned |
| total_calories | int | Basal + active (optional) |
| steps | int | Step count |
| workout_duration_min | int | Total workout minutes |
| resting_hr | int | Resting heart rate (bpm) |
| sleep_hours | numeric | Hours of sleep |
| weight_kg | numeric | From smart scale (optional) |

Data upserts on `date` — running the shortcut multiple times per day just updates the values.

---

## First-Time Setup

1. Run the SQL from `supabase-setup.sql` (the apple_health_logs section) in your Supabase SQL Editor
2. Create the Shortcut as described above
3. Run it once manually to verify data appears in the Progress tab
4. Set up the 10 PM automation
