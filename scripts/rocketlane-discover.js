const API_KEY = process.env.ROCKETLANE_API_KEY;
const BASE = 'https://api.rocketlane.com/api/1.0';
const DRY_RUN = process.env.DRY_RUN !== 'false';

const MIN_WEEKLY_MINUTES = 40 * 60;
const VACATION_PHASE = 'vacation_and_holidays';
const ONBOARDING_PHASE = 'onboarding';
const SETUP_PHASE = 'setup_recurring_use_case';
const MAINTENANCE_PHASE = 'maintenance_recurring_use_case';
const ONBOARDING_TENURE_MONTHS = 3;
const ROLE_MOSTLY_THRESHOLD = 0.5; // TK: confirm what "mostly" should mean

if (!API_KEY) {
  console.error('Missing ROCKETLANE_API_KEY');
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'api-key': API_KEY, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function patch(path, body) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] would PATCH ${path} with`, JSON.stringify(body));
    return { dryRun: true };
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'api-key': API_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function getAllPages(path) {
  let results = [];
  let pageToken;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = pageToken ? `${path}${sep}pageToken=${pageToken}` : path;
    const res = await get(url);
    results = results.concat(res.data || []);
    pageToken = res.pagination && res.pagination.hasMore ? res.pagination.nextPageToken : null;
  } while (pageToken);
  return results;
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthsBetween(fromMs, toMs) {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = process.env.WEEK_START || mondayOf(addDays(today, -7));
  const weekEnd = addDays(weekStart, 6);
  console.log(`Reviewing week ${weekStart} to ${weekEnd} (dry run: ${DRY_RUN})`);

  const users = await getAllPages('/users?status.eq=ACTIVE');
  const userById = new Map(users.map((u) => [u.userId, u]));

  const entries = await getAllPages(
    `/time-entries?approvalStatus.eq=SUBMITTED&date.ge=${weekStart}&date.le=${weekEnd}&includeFields=status,submittedBy,submittedAt`
  );

  const byUser = new Map();
  for (const e of entries) {
    const uid = e.user.userId;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(e);
  }

  const results = [];

  for (const [userId, userEntries] of byUser) {
    const user = userById.get(userId);
    const reasons = [];

    const totalMinutes = userEntries.reduce((sum, e) => sum + e.minutes, 0);
    if (totalMinutes < MIN_WEEKLY_MINUTES) {
      reasons.push(`Only ${(totalMinutes / 60).toFixed(1)}h logged, below the 40h minimum`);
    }

    const nonTimeTracking = userEntries.filter(
      (e) => !(e.project && e.project.projectName.toLowerCase().includes('time tracking'))
    );
    if (nonTimeTracking.length) {
      reasons.push(`${nonTimeTracking.length} entries not on a "Time Tracking" project (e.g. "${nonTimeTracking[0].project?.projectName}")`);
    }

    const missingPhase = userEntries.filter((e) => !e.projectPhase);
    if (missingPhase.length) {
      reasons.push(`${missingPhase.length} entries with no work/phase selected`);
    }

    if (user) {
      const tenureMonths = monthsBetween(user.createdAt, Date.now());
      if (tenureMonths > ONBOARDING_TENURE_MONTHS) {
        const onOnboarding = userEntries.filter((e) => e.projectPhase && e.projectPhase.phaseName === ONBOARDING_PHASE);
        if (onOnboarding.length) {
          reasons.push(`${onOnboarding.length} entries on "onboarding" despite ${tenureMonths}mo tenure (>3mo limit)`);
        }
      }
    } else {
      reasons.push('User not found in active roster');
    }

    const vacationEntries = userEntries.filter((e) => e.projectPhase && e.projectPhase.phaseName === VACATION_PHASE);
    const badVacation = vacationEntries.filter((e) => e.minutes !== 480 && e.minutes !== 240);
    if (badVacation.length) {
      reasons.push(`${badVacation.length} vacation entries not exactly 8h or 4h (e.g. ${(badVacation[0].minutes / 60).toFixed(1)}h)`);
    }

    if (user && user.role && user.role.roleName) {
      const roleName = user.role.roleName.toLowerCase();
      const setupMinutes = userEntries.filter((e) => e.projectPhase?.phaseName === SETUP_PHASE).reduce((s, e) => s + e.minutes, 0);
      const maintenanceMinutes = userEntries.filter((e) => e.projectPhase?.phaseName === MAINTENANCE_PHASE).reduce((s, e) => s + e.minutes, 0);
      const relevantTotal = setupMinutes + maintenanceMinutes;
      if (relevantTotal > 0) {
        if (roleName.includes('deployment') && !roleName.includes('ongoing delivery')) {
          const setupShare = setupMinutes / relevantTotal;
          if (setupShare < ROLE_MOSTLY_THRESHOLD) {
            reasons.push(`Deployment role but only ${(setupShare * 100).toFixed(0)}% of setup/maintenance hours are setup`);
          }
        } else if (roleName.includes('ongoing delivery')) {
          const maintenanceShare = maintenanceMinutes / relevantTotal;
          if (maintenanceShare < ROLE_MOSTLY_THRESHOLD) {
            reasons.push(`Ongoing Delivery role but only ${(maintenanceShare * 100).toFixed(0)}% of setup/maintenance hours are maintenance`);
          }
        }
      }
    }

    const decision = reasons.length === 0 ? 'APPROVE' : 'NEEDS_REVIEW';
    results.push({
      userId,
      email: user?.email,
      name: user ? `${user.firstName} ${user.lastName || ''}`.trim() : null,
      totalHours: (totalMinutes / 60).toFixed(1),
      decision,
      reasons,
    });
  }

  console.log(JSON.stringify(results, null, 2));

  for (const r of results) {
    if (r.decision === 'APPROVE') {
      console.log(`Approving ${r.email} for week ${weekStart}...`);
      await patch(`/users/${r.userId}/approve-timesheet`, { date: weekStart });
    }
  }

  const approved = results.filter((r) => r.decision === 'APPROVE').length;
  const needsReview = results.filter((r) => r.decision === 'NEEDS_REVIEW').length;
  console.log(`\nDone. ${approved} approved, ${needsReview} need human review.`);
})().catch((err) => {
  console.error('Review run failed:', err.message);
  process.exit(1);
});
