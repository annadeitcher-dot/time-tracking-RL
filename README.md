# gtm-lab

Anna's GTM lab and agent playground.

## Rocketlane Timesheet Review

Automated first-pass review of weekly timesheets for AI Deployment and Ongoing Delivery roles, built on the Rocketlane API.

### Status: crawl mode

`DRY_RUN` defaults to `true` (`scripts/rocketlane-discover.js:3`), so the workflow currently **logs** approve/reject/escalate decisions and posts them to Slack (via Tray) without calling Rocketlane's approve/reject endpoints. The goal right now is to verify the decision logic is correct before it's allowed to act.

### How it runs

- **Trigger:** GitHub Actions, `.github/workflows/rocketlane-timesheet-review.yml` — cron `Tue/Fri 13:00 UTC` (normal review run), `Wed 13:00 UTC` (manager escalation follow-up, one day after Tuesday's run only — deliberately not scheduled after Friday's run, to avoid pinging managers over the weekend), or manual `workflow_dispatch`.
- **Script:** `scripts/rocketlane-discover.js`
- **Secrets required:** `ROCKETLANE_API_KEY`, `TRAY_WEBHOOK_URL`

### What it does

1. Pulls active `@braze.com` users in 6 tracked roles (AI Deployment FDS/Lead, Ongoing Delivery FDS/Lead, Data Standards Manager, Engagement Manager).
2. Pulls time entries for the current week plus a rolling lookback (`LOOKBACK_WEEKS`, default 4).
3. For each user/week, categorizes as `clean`, `MISSING`, `INCOMPLETE_NOT_SUBMITTED`, `REJECTED_NOT_RESUBMITTED`, or `OUTSTANDING`.
4. For the current week specifically, runs `evaluateWeek()` against the approve/reject rules:
   - Weekly total must fall between 40h and 65h.
   - Every entry must be on a "Time Tracking" project with a phase set.
   - Vacation entries must be exactly 4h or 8h.
   - Onboarding-phase time flagged if tenure > 3 months.
   - Deployment/Ongoing Delivery roles must spend the majority of setup-or-maintenance time on their expected phase (`ROLE_MOSTLY_THRESHOLD` — **TODO: confirm exact threshold**, currently 0.5).
   - Non-manager admin-phase time capped at 20h before flagging.
   - Time on `poc`, `portal_migration`, or `pilot` phases is always flagged for review.
5. Users with ≥2 missing weeks or ≥2 unresolved rejections in the lookback window are flagged for escalation (`ESCALATE_AFTER`).
6. Approve/reject actions (real or dry-run) are sent to Rocketlane via PATCH.
7. A summary — approvals, rejections with reasons, escalations, tagged `kind: "weekly_review"` — is POSTed to the Tray webhook, which relays it to the ops Slack channel.
8. The following Wednesday (one day after the Tuesday run only — not after Friday's, to avoid a weekend ping), the same script runs again with `MANAGER_FOLLOWUP_ONLY=true`: it skips the Rocketlane PATCH calls, re-derives that week's escalation list read-only, and — only if there's at least one outstanding escalation — POSTs a separate `kind: "manager_escalation"` payload to the same Tray webhook, which Tray routes to the managers Slack channel instead of the ops channel. Escalations flagged on the Friday run do not currently get this follow-up ping.

### Data

- `data/managers.csv` — name/email/manager mapping. Wired into `scripts/rocketlane-discover.js`'s manager-followup path: each escalated person's `manager_name` is looked up by email and included in the Slack message Tray builds for the managers channel.

### Known issues / cleanup

- `ROLE_MOSTLY_THRESHOLD` in `scripts/rocketlane-discover.js` is a placeholder (`// TK: confirm exact threshold`) and directly affects real approve/reject outcomes — confirm before leaving crawl mode.
- No test coverage for `evaluateWeek()` — worth adding before the reject path goes live, since a bad rule change would generate incorrect rejection notes sent to real employees.

### Roadmap

1. **Verify crawl-mode logic** — confirm approve/reject/escalate decisions match expectations against real historical data before enabling live PATCHes.
2. ~~**Manager escalations**~~ — done: the Wed/Sat follow-up run routes the `escalate` list, with each person's manager name from `data/managers.csv`, to a dedicated managers Slack channel via Tray.
3. **Approve/reject API endpoints** — expose endpoints so timesheets can be approved/rejected directly (outside the cron cycle), rather than only via the scheduled batch job.
