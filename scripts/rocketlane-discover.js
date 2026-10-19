const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ROCKETLANE_API_KEY;
const BASE_URL = 'https://api.rocketlane.com/api/1.0';
const DRY_RUN = process.env.DRY_RUN !== 'false';
const LOOKBACK_WEEKS = parseInt(process.env.LOOKBACK_WEEKS || '4', 10);
const ESCALATE_AFTER = 2;
const TRAY_WEBHOOK_URL = process.env.TRAY_WEBHOOK_URL;
const MANAGER_FOLLOWUP_ONLY = process.env.MANAGER_FOLLOWUP_ONLY === 'true';
const MANAGERS_CSV_PATH = path.join(__dirname, '..', 'data', 'managers.csv');

const MIN_WEEKLY_MINUTES = 40 * 60;
const MAX_WEEKLY_MINUTES = 65 * 60;
const VACATION_PHASE = 'vacation_and_holidays';
const ONBOARDING_PHASE = 'onboarding';
const SETUP_PHASE = 'setup_recurring_use_case';
const MAINTENANCE_PHASE = 'maintenance_recurring_use_case';
const ADMIN_PHASE = 'admin';
const REVIEW_PHASES = ['poc', 'portal_migration', 'pilot'];
const ADMIN_FLAG_MINUTES = 20 * 60;
const ONBOARDING_TENURE_MONTHS = 3;
const ROLE_MOSTLY_THRESHOLD = 0.5; // TK: confirm exact threshold
const TIME_TRACKING_DOC = 'https://docs.google.com/document/d/11zdx8IMfaCseZ4EdfssiQ5hPg4mkasZgTHjXFwEpQAA/edit?tab=t.0#heading=h.e6jlmxweq7jv';

const INCLUDED_ROLE_IDS = {
  97072: 'ai_deployment_fds',
  105925: 'ai_deployment_fds_lead',
  104355: 'ongoing_delivery_fds',
  109786: 'ongoing_delivery_fds_lead',
  102474: 'data_standards_manager',
  97069: 'engagement_manager',
};
const DEPLOYMENT_CATEGORIES = ['ai_deployment_fds', 'ai_deployment_fds_lead'];
const ONGOING_DELIVERY_CATEGORIES = ['ongoing_delivery_fds', 'ongoing_delivery_fds_lead'];
const MANAGER_OR_LEAD_CATEGORIES = ['ai_deployment_fds_lead', 'ongoing_delivery_fds_lead', 'data_standards_manager', 'engagement_manager'];

function loadManagerMap() {
  const map = new Map();
  let raw;
  try {
    raw = fs.readFileSync(MANAGERS_CSV_PATH, 'utf8');
  } catch (err) {
    console.warn(`[managers.csv] could not read ${MANAGERS_CSV_PATH}: ${err.message}`);
    return map;
  }
  const lines = raw.trim().split('\n');
  for (const line of lines.slice(1)) {
    const [, email, managerName] = line.split(',');
    if (email) map.set(email.trim().toLowerCase(), (managerName || '').trim());
  }
  return map;
}

function nameOf(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { 'api-key': API_KEY } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function patch(path, body) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] would PATCH ${path}`, JSON.stringify(body));
    return null;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getAllPages(path) {
  let results = [];
  let pageToken;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const pageParam = pageToken ? `${sep}pageToken=${pageToken}` : '';
    const page = await get(`${path}${pageParam}`);
    results = results.concat(page.data || []);
    pageToken = page.pagination?.hasMore ? page.pagination.nextPageToken : undefined;
  } while (pageToken);
  return results;
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthsBetween(fromMs, toMs) {
  return (toMs - fromMs) / (1000 * 60 * 60 * 24 * 30.44);
}

function buildRejectNote(reasons) {
  const bullets = reasons.map(r => `- ${r}`).join('\n');
  return `This week's timesheet needs correction before it can be approved:\n${bullets}\n\nPlease fix the flagged entries and resubmit the full week (partial corrections aren't accepted).\nInstructions: ${TIME_TRACKING_DOC}`;
}

async function postToTray(payload) {
  if (!TRAY_WEBHOOK_URL) {
    console.log('[TRAY] TRAY_WEBHOOK_URL not set — skipping Slack delivery, recs are in this log only.');
    return;
  }
  const res = await fetch(TRAY_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`[TRAY] webhook POST failed: ${res.status} ${await res.text()}`);
  }
}

// Runs the shared approve/reject criteria against one person's one week.
// pending = SUBMITTED entries (drive per-entry checks)
// counted = SUBMITTED + APPROVED entries (drive the hour-total checks)
function evaluateWeek(pending, counted, user) {
  const reasons = [];
  const totalMinutes = counted.reduce((sum, e) => sum + (e.minutes || 0), 0);

  if (totalMinutes < MIN_WEEKLY_MINUTES) {
    reasons.push(`Total ${(totalMinutes / 60).toFixed(1)}h is under the 40h floor`);
  }
  if (totalMinutes > MAX_WEEKLY_MINUTES) {
    reasons.push(`Total ${(totalMinutes / 60).toFixed(1)}h exceeds the 65h ceiling`);
  }

  for (const e of pending) {
    if (!e.project?.projectName?.startsWith('Time Tracking')) {
      reasons.push(`Entry on non-"Time Tracking" project: ${e.project?.projectName}`);
    }
    if (!e.projectPhase?.phaseName) {
      reasons.push('Entry missing a work phase');
    }
  }

  const tenureMonths = user.createdAt ? monthsBetween(new Date(user.createdAt).getTime(), Date.now()) : null;
  if (tenureMonths !== null && tenureMonths > ONBOARDING_TENURE_MONTHS) {
    const onboardingEntries = pending.filter(e => e.projectPhase?.phaseName === ONBOARDING_PHASE);
    if (onboardingEntries.length > 0) {
      reasons.push(`Tracking to onboarding phase but tenure is ${tenureMonths.toFixed(1)} months`);
    }
  }

  const vacationEntries = pending.filter(e => e.projectPhase?.phaseName === VACATION_PHASE);
  for (const e of vacationEntries) {
    if (e.minutes !== 480 && e.minutes !== 240) {
      reasons.push(`Vacation entry is ${(e.minutes / 60).toFixed(1)}h, not 8h or 4h`);
    }
  }

  const isDeployment = DEPLOYMENT_CATEGORIES.includes(user.roleCategory);
  const isOngoingDelivery = ONGOING_DELIVERY_CATEGORIES.includes(user.roleCategory);
  if (isDeployment || isOngoingDelivery) {
    const setupMinutes = pending.filter(e => e.projectPhase?.phaseName === SETUP_PHASE).reduce((s, e) => s + e.minutes, 0);
    const maintMinutes = pending.filter(e => e.projectPhase?.phaseName === MAINTENANCE_PHASE).reduce((s, e) => s + e.minutes, 0);
    const relevant = setupMinutes + maintMinutes;
    if (relevant > 0) {
      const share = isDeployment ? setupMinutes / relevant : maintMinutes / relevant;
      if (share < ROLE_MOSTLY_THRESHOLD) {
        reasons.push(`${isDeployment ? 'Deployment' : 'Ongoing Delivery'} role but only ${(share * 100).toFixed(0)}% on the expected phase`);
      }
    }
  }

  const isManagerOrLead = MANAGER_OR_LEAD_CATEGORIES.includes(user.roleCategory);
  if (!isManagerOrLead) {
    const adminMinutes = pending.filter(e => e.projectPhase?.phaseName === ADMIN_PHASE).reduce((s, e) => s + e.minutes, 0);
    if (adminMinutes > ADMIN_FLAG_MINUTES) {
      reasons.push(`${(adminMinutes / 60).toFixed(1)}h on admin phase, over the 20h flag threshold`);
    }
  }

  const reviewEntries = pending.filter(e => REVIEW_PHASES.includes(e.projectPhase?.phaseName));
  if (reviewEntries.length > 0) {
    reasons.push(`Time tracked to ${[...new Set(reviewEntries.map(e => e.projectPhase.phaseName))].join(', ')} — always flagged for review`);
  }

  return { decision: reasons.length === 0 ? 'APPROVE' : 'REJECT', reasons, totalMinutes };
}
// The manager follow-up runs 1 day after Tuesday's review (Wednesday) or
// 3 days after Friday's review (the following Monday, skipping the weekend).
// Either way it must re-derive the SAME weekStart the preceding primary run
// used — Mon and Fri fall in different ISO weeks, so "today" can't be used
// directly the way the primary run uses it.
function followupAnchorDate(todayStr) {
  const dow = new Date(todayStr + 'T00:00:00Z').getUTCDay(); // 0=Sun..6=Sat
  if (dow === 1) return addDays(todayStr, -3); // Monday -> back to Friday
  if (dow === 3) return addDays(todayStr, -1); // Wednesday -> back to Tuesday
  return addDays(todayStr, -1); // fallback for an ad-hoc manual run
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const anchorDate = MANAGER_FOLLOWUP_ONLY ? followupAnchorDate(today) : today;
  const weekStart = addDays(mondayOf(anchorDate), -7);
  const weekEnd = addDays(weekStart, 6);
  const lookbackStart = addDays(weekStart, -7 * LOOKBACK_WEEKS);

  const usersByRole = await Promise.all(
    Object.entries(INCLUDED_ROLE_IDS).map(([roleId, category]) =>
      getAllPages(`/users?status.eq=ACTIVE&roleId.eq=${roleId}`).then(list =>
        list
          .filter(u => (u.email || '').toLowerCase().endsWith('@braze.com'))
          .map(u => ({ ...u, roleCategory: category }))
      )
    )
  );
  const users = usersByRole.flat();

  const includeFields = 'status,submittedBy,submittedAt,approvedBy,approvedAt,rejectedBy,rejectedAt';
  const entries = await getAllPages(
    `/time-entries?date.ge=${lookbackStart}&date.le=${weekEnd}&includeFields=${includeFields}`
  );

  // byUserWeek: userId -> weekStart -> entries[]
  const byUserWeek = new Map();
  for (const e of entries) {
    const wk = mondayOf(e.date);
    const uid = e.user?.userId;
    if (!uid) continue;
    if (!byUserWeek.has(uid)) byUserWeek.set(uid, new Map());
    const userWeeks = byUserWeek.get(uid);
    if (!userWeeks.has(wk)) userWeeks.set(wk, []);
    userWeeks.get(wk).push(e);
  }

  const weeksInWindow = [];
  for (let i = 0; i < LOOKBACK_WEEKS + 1; i++) {
    weeksInWindow.push(addDays(weekStart, -7 * i));
  }
  weeksInWindow.reverse(); // oldest first, current week last

  const perUserSummary = [];
  const approveActions = [];
  const rejectActions = [];

  for (const user of users) {
    const userWeeks = byUserWeek.get(user.userId) || new Map();
    const hireMonday = user.createdAt ? mondayOf(new Date(user.createdAt).toISOString().slice(0, 10)) : null;
    const weekFlags = [];
    let missingCount = 0;
    let unresolvedRejectionCount = 0;

    for (const wk of weeksInWindow) {
      if (hireMonday && wk < hireMonday) continue; // week before they joined

      const weekEntries = userWeeks.get(wk) || [];
      const pending = weekEntries.filter(e => e.status === 'SUBMITTED');
      const counted = weekEntries.filter(e => e.status === 'SUBMITTED' || e.status === 'APPROVED');
      const rejected = weekEntries.filter(e => e.status === 'REJECTED');

      let category;
      let evalResult = null;

      if (weekEntries.length === 0) {
        category = 'MISSING';
        missingCount++;
      } else if (pending.length === 0 && rejected.length > 0) {
        category = 'REJECTED_NOT_RESUBMITTED';
        unresolvedRejectionCount++;
      } else if (pending.length === 0) {
        const draftMinutes = weekEntries.reduce((s, e) => s + (e.minutes || 0), 0);
        category = draftMinutes < MIN_WEEKLY_MINUTES ? 'INCOMPLETE_NOT_SUBMITTED' : 'clean';
      } else {
        evalResult = evaluateWeek(pending, counted, user);
        category = evalResult.decision === 'APPROVE' ? 'clean' : 'OUTSTANDING';
      }

      if (category !== 'clean') {
        weekFlags.push({ week: wk, category, reasons: evalResult?.reasons || [] });
      }

      if (wk === weekStart && category === 'clean' && pending.length > 0) {
        approveActions.push({ userId: user.userId, date: weekStart, name: nameOf(user), email: user.email });
      }

      if (wk === weekStart && category === 'OUTSTANDING') {
        rejectActions.push({ userId: user.userId, date: weekStart, name: nameOf(user), email: user.email, rejectNote: buildRejectNote(evalResult.reasons), reasons: evalResult.reasons });
      }
    }

    const escalate = missingCount >= ESCALATE_AFTER || unresolvedRejectionCount >= ESCALATE_AFTER;

    if (weekFlags.length > 0 || escalate) {
      perUserSummary.push({
        userId: user.userId,
        name: nameOf(user),
        email: user.email,
        missingCount,
        unresolvedRejectionCount,
        escalate,
        weekFlags,
      });
    }
  }

  console.log('=== Lookback report ===');
  console.log(JSON.stringify({ weekStart, lookbackStart, weeksChecked: weeksInWindow.length, perUserSummary }, null, 2));

  const managerByEmail = loadManagerMap();
  const escalations = perUserSummary
    .filter(u => u.escalate)
    .map(u => ({
      name: u.name,
      email: u.email,
      missingCount: u.missingCount,
      unresolvedRejectionCount: u.unresolvedRejectionCount,
      managerName: managerByEmail.get((u.email || '').toLowerCase()) || null,
    }));

  if (MANAGER_FOLLOWUP_ONLY) {
    console.log(`=== Manager follow-up (${escalations.length} escalations) ===`);
    if (escalations.length === 0) {
      console.log('No escalations outstanding — skipping manager notification.');
      return;
    }
    await postToTray({ kind: 'manager_escalation', weekStart, dryRun: DRY_RUN, escalations });
    return;
  }

  console.log(`=== Current week approvals (${approveActions.length}) ===`);
  for (const action of approveActions) {
    await patch(`/users/${action.userId}/approve-timesheet`, { date: action.date });
  }

  console.log(`=== Current week rejections (${rejectActions.length}) ===`);
  for (const action of rejectActions) {
    await patch(`/users/${action.userId}/reject-timesheet`, { date: action.date, rejectNote: action.rejectNote });
  }

  await postToTray({
    kind: 'weekly_review',
    weekStart,
    dryRun: DRY_RUN,
    approved: approveActions.map(a => ({ name: a.name, email: a.email })),
    rejected: rejectActions.map(a => ({ name: a.name, email: a.email, reasons: a.reasons })),
    escalations,
    flaggedUserCount: perUserSummary.length,
  });
}

main().catch(err => {
  console.error('Discovery run failed:', err.message);
  process.exit(1);
});
