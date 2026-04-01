# N8N Workflow Health Email Report

This project sends a daily HTML workflow health report from n8n to Gmail. It pulls workflow and execution data from the n8n API, builds an executive-summary email, and sends it to one or more recipients. The same run also updates the static dashboard snapshot used by `dashboard.html`.

## Current behavior

- Runs daily at `08:35 AM` on Windows Task Scheduler
- Sends the previous calendar day's data only
- Example: a run on `April 2, 2026 at 08:35 AM` reports `April 1, 2026 00:00:00` to `April 1, 2026 23:59:59`
- Sends to the recipients configured in `REPORT_TO`

## Email contents

- Subject format: `N8N Workflow Health | 31 MARCH 2026`
- Executive snapshot:
  - Active workflows
  - Total executions
  - Failed executions
  - Success rate
- Dashboard snapshot:
  - Writes `dashboard-data.js` for `dashboard.html`
  - Includes the current report day summary, top failures, active workflow table, and a 7-day executions trend
- Failures section:
  - Top failed workflows for the reporting day
- Workflow table:
  - Only currently active workflows from n8n
  - Columns: workflow, link, runs, failed, success, success rate

## Files

- `send-n8n-report.mjs`: Fetches data from n8n, calculates the previous-day report, renders the HTML email, sends it through Gmail SMTP, and writes the dashboard snapshot
- `dashboard.html`: Static dashboard UI that renders from `dashboard-data.js`
- `dashboard-data.js`: Generated dashboard snapshot file consumed by `dashboard.html`
- `run-report.ps1`: Runs the report sender from the project directory
- `register-report-task.ps1`: Registers the daily Windows scheduled task
- `.env.example`: Template for required environment variables

## Architecture

- See [ARCHITECTURE.md](./ARCHITECTURE.md) for the workflow diagram and data flow.

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:
   - `N8N_BASE_URL`
   - `N8N_API_KEY`
   - `GMAIL_USER`
   - `GMAIL_APP_PASSWORD`
   - `REPORT_TO`
3. Install dependencies

```powershell
npm install
```

4. Send a manual test

```powershell
node .\send-n8n-report.mjs
```

To refresh only the dashboard snapshot without sending email:

```powershell
$env:REPORT_DISABLE_EMAIL="true"
node .\send-n8n-report.mjs
Remove-Item Env:REPORT_DISABLE_EMAIL
```

5. Register the daily schedule

```powershell
powershell -ExecutionPolicy Bypass -File .\register-report-task.ps1 -At 08:35
```

## Gmail note

Use a Gmail App Password, not your normal Gmail password. App Passwords require Google 2-Step Verification.

## Scheduling note

This project uses Windows Task Scheduler, not Linux `cron`.
