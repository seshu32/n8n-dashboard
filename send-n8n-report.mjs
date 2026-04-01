import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import nodemailer from "nodemailer";

const ENV_PATH = path.join(process.cwd(), ".env");
const DASHBOARD_DATA_PATH = path.join(process.cwd(), "dashboard-data.js");

loadEnvFile(ENV_PATH);

const config = {
  n8nBaseUrl: requiredEnv("N8N_BASE_URL").replace(/\/+$/, ""),
  n8nApiKey: requiredEnv("N8N_API_KEY"),
  gmailUser: requiredEnv("GMAIL_USER"),
  gmailAppPassword: requiredEnv("GMAIL_APP_PASSWORD"),
  reportTo: requiredEnv("REPORT_TO"),
  reportFrom: process.env.REPORT_FROM || process.env.GMAIL_USER,
  subjectPrefix: process.env.REPORT_SUBJECT_PREFIX || "N8N Workflow Health",
  timezone: process.env.REPORT_TIMEZONE || "Asia/Calcutta",
};
const shouldSendEmail = !isTruthy(process.env.REPORT_DISABLE_EMAIL);

const now = new Date();
const reportWindow = getPreviousDayWindow(now, config.timezone);
const trailingWindows = getTrailingDayWindows(reportWindow.startTime, config.timezone, 7);
const comparisonWindow = trailingWindows[trailingWindows.length - 2];
const currentWindow = trailingWindows[trailingWindows.length - 1];

const workflows = await fetchAllPages("/api/v1/workflows", {
  active: "true",
  limit: "250",
});

const executions = await fetchExecutions(trailingWindows[0].startTime);

const report = buildReport({
  workflows,
  executions,
  startTime: currentWindow.startTime,
  endTime: currentWindow.endTime,
  previousStartTime: comparisonWindow.startTime,
  previousEndTime: comparisonWindow.endTime,
  chartWindows: trailingWindows,
  timezone: config.timezone,
  baseUrl: config.n8nBaseUrl,
});

writeDashboardDataFile(report);

if (shouldSendEmail) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: config.gmailUser,
      pass: config.gmailAppPassword,
    },
  });

  const subject = `${config.subjectPrefix} | ${formatSubjectDate(reportWindow.startTime, config.timezone)}`;

  await transporter.sendMail({
    from: config.reportFrom,
    to: config.reportTo,
    subject,
    html: renderEmailHtml(report, config.timezone),
  });

  console.log(`Report sent to ${config.reportTo}`);
} else {
  console.log(`Dashboard data updated without sending email: ${DASHBOARD_DATA_PATH}`);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchExecutions(oldestNeeded) {
  const collected = [];
  let cursor;
  let keepFetching = true;

  while (keepFetching) {
    const params = {
      limit: "250",
    };

    if (cursor) {
      params.cursor = cursor;
    }

    const page = await fetchApi("/api/v1/executions", params);
    const rows = getPageData(page);

    if (!rows.length) {
      break;
    }

    collected.push(...rows);

    const oldestExecution = rows
      .map((execution) => getExecutionTimestamp(execution))
      .filter(Boolean)
      .sort((left, right) => left - right)[0];

    if (!oldestExecution || oldestExecution <= oldestNeeded) {
      break;
    }

    cursor = getNextCursor(page);
    if (!cursor) {
      keepFetching = false;
    }
  }

  return collected;
}

async function fetchAllPages(endpoint, initialParams) {
  const collected = [];
  let cursor;

  while (true) {
    const params = { ...initialParams };
    if (cursor) {
      params.cursor = cursor;
    }

    const page = await fetchApi(endpoint, params);
    collected.push(...getPageData(page));
    cursor = getNextCursor(page);

    if (!cursor) {
      break;
    }
  }

  return collected;
}

async function fetchApi(endpoint, params) {
  const url = new URL(`${config.n8nBaseUrl}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "X-N8N-API-KEY": config.n8nApiKey,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`n8n API request failed (${response.status}) for ${url}: ${message}`);
  }

  return response.json();
}

function getPageData(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  return [];
}

function getNextCursor(payload) {
  return payload?.nextCursor || payload?.cursor?.next || payload?.meta?.nextCursor || null;
}

function buildReport({
  workflows,
  executions,
  startTime,
  endTime,
  previousStartTime,
  previousEndTime,
  chartWindows,
  timezone,
  baseUrl,
}) {
  const workflowMap = new Map();
  const activeWorkflowIds = new Set();
  const activeWorkflowCount = workflows.filter((workflow) => workflow.active !== false).length;

  for (const workflow of workflows) {
    const workflowId = String(workflow.id);
    if (workflow.active !== false) {
      activeWorkflowIds.add(workflowId);
    }
    workflowMap.set(workflowId, {
      id: workflowId,
      name: workflow.name || `Workflow ${workflowId}`,
      active: workflow.active !== false,
      link: `${baseUrl.replace(/\/$/, "")}/workflow/${workflowId}`,
    });
  }

  const currentWindow = createBucket();
  const previousWindow = createBucket();
  const trendBuckets = chartWindows.map((window) => ({
    ...window,
    bucket: createBucket(),
  }));

  for (const execution of executions) {
    const timestamp = getExecutionTimestamp(execution);
    if (!timestamp) {
      continue;
    }

    const workflowId = getWorkflowId(execution);
    const normalizedWorkflowId = String(workflowId || execution.workflowId || execution.workflow?.id || "unknown");
    const workflow = getWorkflowRecord(workflowMap, workflowId, execution, baseUrl);
    const status = normalizeExecutionStatus(execution);

    if (!activeWorkflowIds.has(normalizedWorkflowId)) {
      continue;
    }

    if (timestamp >= startTime && timestamp <= endTime) {
      updateBucket(currentWindow, workflow, status);
    } else if (timestamp >= previousStartTime && timestamp <= previousEndTime) {
      updateBucket(previousWindow, workflow, status);
    }

    const trendBucket = trendBuckets.find(
      (window) => timestamp >= window.startTime && timestamp <= window.endTime
    );

    if (trendBucket) {
      updateBucket(trendBucket.bucket, workflow, status);
    }
  }

  // Ensure every active workflow appears in the report, even if it had no runs
  // in the current 24-hour window.
  for (const workflow of workflowMap.values()) {
    if (!workflow.active) {
      continue;
    }

    if (!currentWindow.workflows.has(workflow.id)) {
      currentWindow.workflows.set(workflow.id, {
        ...workflow,
        runs: 0,
        failed: 0,
        success: 0,
        successRate: 0,
        failureRate: 0,
      });
    }
  }

  const rows = Array.from(currentWindow.workflows.values())
    .filter((row) => activeWorkflowIds.has(row.id))
    .sort((left, right) => {
      if (right.failed !== left.failed) {
        return right.failed - left.failed;
      }
      if (right.runs !== left.runs) {
        return right.runs - left.runs;
      }
      return left.name.localeCompare(right.name);
    });

  const topFailures = rows.filter((row) => row.failed > 0).slice(0, 5);
  const summary = buildSummary(currentWindow, previousWindow);
  summary.activeWorkflows = activeWorkflowCount;

  return {
    summary,
    rows,
    topFailures,
    trend: trendBuckets.map((entry) => ({
      label: entry.label,
      totalExecutions: entry.bucket.totalExecutions,
      failedExecutions: entry.bucket.failedExecutions,
      successfulExecutions: entry.bucket.successfulExecutions,
      workflowsRan: entry.bucket.workflowsRan,
    })),
    reportDateLabel: formatDate(startTime, timezone),
    windowLabel: `${formatDateTime(startTime, timezone)} to ${formatDateTime(endTime, timezone)}`,
    generatedAt: new Date().toISOString(),
  };
}

function createBucket() {
  return {
    workflows: new Map(),
    workflowsRan: 0,
    totalExecutions: 0,
    failedExecutions: 0,
    successfulExecutions: 0,
  };
}

function updateBucket(bucket, workflow, status) {
  if (!bucket.workflows.has(workflow.id)) {
    bucket.workflows.set(workflow.id, {
      ...workflow,
      runs: 0,
      failed: 0,
      success: 0,
      successRate: 0,
      failureRate: 0,
    });
    bucket.workflowsRan += 1;
  }

  const row = bucket.workflows.get(workflow.id);
  row.runs += 1;
  bucket.totalExecutions += 1;

  if (status === "failed") {
    row.failed += 1;
    bucket.failedExecutions += 1;
  } else if (status === "success") {
    row.success += 1;
    bucket.successfulExecutions += 1;
  }

  row.successRate = row.runs ? (row.success / row.runs) * 100 : 0;
  row.failureRate = row.runs ? (row.failed / row.runs) * 100 : 0;
}

function buildSummary(currentWindow, previousWindow) {
  const currentSuccessRate = currentWindow.totalExecutions
    ? (currentWindow.successfulExecutions / currentWindow.totalExecutions) * 100
    : 0;
  const previousSuccessRate = previousWindow.totalExecutions
    ? (previousWindow.successfulExecutions / previousWindow.totalExecutions) * 100
    : 0;

  return {
    workflowsRan: currentWindow.workflowsRan,
    totalExecutions: currentWindow.totalExecutions,
    failedExecutions: currentWindow.failedExecutions,
    successRate: currentSuccessRate,
    deltas: {
      workflowsRan: currentWindow.workflowsRan - previousWindow.workflowsRan,
      totalExecutions: currentWindow.totalExecutions - previousWindow.totalExecutions,
      failedExecutions: currentWindow.failedExecutions - previousWindow.failedExecutions,
      successRate: currentSuccessRate - previousSuccessRate,
    },
  };
}

function writeDashboardDataFile(report) {
  const payload = {
    generatedAt: report.generatedAt,
    reportDateLabel: report.reportDateLabel,
    windowLabel: report.windowLabel,
    summary: report.summary,
    topFailures: report.topFailures,
    rows: report.rows,
    trend: report.trend,
  };

  const content = `window.__DASHBOARD_DATA__ = ${JSON.stringify(payload, null, 2)};\n`;
  fs.writeFileSync(DASHBOARD_DATA_PATH, content, "utf8");
}

function getWorkflowRecord(workflowMap, workflowId, execution, baseUrl) {
  const key = String(workflowId || execution.workflowId || execution.workflow?.id || "unknown");

  if (!workflowMap.has(key)) {
    const fallbackName =
      execution.workflowData?.name ||
      execution.workflow?.name ||
      execution.workflowName ||
      `Workflow ${key}`;

    workflowMap.set(key, {
      id: key,
      name: fallbackName,
      active: true,
      link: key === "unknown" ? baseUrl : `${baseUrl.replace(/\/$/, "")}/workflow/${key}`,
    });
  }

  return workflowMap.get(key);
}

function getExecutionTimestamp(execution) {
  const rawValue =
    execution.startedAt ||
    execution.started_at ||
    execution.createdAt ||
    execution.finishedAt ||
    execution.stoppedAt;

  if (!rawValue) {
    return null;
  }

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function getWorkflowId(execution) {
  return (
    execution.workflowId ||
    execution.workflow_id ||
    execution.workflow?.id ||
    execution.workflowData?.id ||
    execution.workflowData?.workflowId
  );
}

function normalizeExecutionStatus(execution) {
  const raw = String(
    execution.status ??
      execution.finished ??
      execution.stoppedAt ??
      execution.mode ??
      ""
  ).toLowerCase();

  if (raw.includes("error") || raw.includes("fail") || raw.includes("crash")) {
    return "failed";
  }

  if (raw === "true" || raw.includes("success")) {
    return "success";
  }

  if (execution.finished === true && !execution.stoppedAt && !raw.includes("error")) {
    return "success";
  }

  return "other";
}

function renderEmailHtml(report, timezone) {
  const failureItems = report.topFailures.length
    ? report.topFailures
        .map((row) => {
          const failureText = `${row.failed} failed out of ${row.runs} runs`;
          return `<li style="margin:0 0 8px 0;"><strong>${escapeHtml(row.name)}</strong> &mdash; ${escapeHtml(failureText)}</li>`;
        })
        .join("")
    : `<li style="margin:0;">No failed executions in this window.</li>`;

  const workflowRows = report.rows.length
    ? report.rows
        .map((row) => {
          return `
            <tr>
              <td style="padding:12px 10px;border-bottom:1px solid #e6e8ed;color:#243042;">${escapeHtml(row.name)}</td>
              <td style="padding:12px 10px;border-bottom:1px solid #e6e8ed;text-align:center;"><a href="${escapeHtml(
                row.link
              )}" style="color:#2563eb;text-decoration:none;">Open</a></td>
              <td style="padding:12px 10px;border-bottom:1px solid #e6e8ed;text-align:right;">${row.runs}</td>
              <td style="padding:12px 10px;border-bottom:1px solid #e6e8ed;text-align:right;">${row.failed}</td>
              <td style="padding:12px 10px;border-bottom:1px solid #e6e8ed;text-align:right;">${row.success}</td>
              <td style="padding:12px 10px;border-bottom:1px solid #e6e8ed;text-align:right;">${formatPercent(row.successRate)}</td>
            </tr>
          `;
        })
        .join("")
    : `
      <tr>
        <td colspan="6" style="padding:16px 10px;text-align:center;color:#6b7280;">
          No workflow executions found in the selected window.
        </td>
      </tr>
    `;

  return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(report.windowLabel)}</title>
    </head>
    <body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#101828;">
      <div style="max-width:900px;margin:0 auto;border-radius:16px;overflow:hidden;background:#ffffff;border:1px solid #e5e7eb;">
        <div style="background:#a7342f;color:#ffffff;padding:18px 18px 16px;">
          <div style="font-size:16px;font-weight:800;letter-spacing:0.02em;">N8N WORKFLOW HEALTH</div>
          <div style="margin-top:4px;font-size:14px;opacity:0.95;">Yesterday: ${escapeHtml(report.reportDateLabel)} (${escapeHtml(timezone)})</div>
        </div>

        <div style="padding:18px;">
          <div style="font-size:16px;font-weight:700;margin:0 0 12px;">Executive Snapshot</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:22px;">
            ${renderMetricCard("ACTIVE WORKFLOWS", report.summary.activeWorkflows)}
            ${renderMetricCard("TOTAL EXECUTIONS", report.summary.totalExecutions)}
            ${renderMetricCard("FAILED EXECUTIONS", report.summary.failedExecutions)}
            ${renderMetricCard("SUCCESS RATE", formatPercent(report.summary.successRate))}
          </div>

          <div style="font-size:16px;font-weight:700;margin:0 0 10px;">Failures</div>
          <ul style="margin:0 0 24px 18px;padding:0;color:#1f2937;line-height:1.45;">
            ${failureItems}
          </ul>

          <div style="font-size:16px;font-weight:700;margin:0 0 10px;">Workflows (All Active)</div>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <thead>
              <tr style="background:#f8fafc;">
                <th style="padding:10px;border:1px solid #e6e8ed;text-align:left;">Workflow</th>
                <th style="padding:10px;border:1px solid #e6e8ed;text-align:center;">Link</th>
                <th style="padding:10px;border:1px solid #e6e8ed;text-align:right;">Runs</th>
                <th style="padding:10px;border:1px solid #e6e8ed;text-align:right;">Failed</th>
                <th style="padding:10px;border:1px solid #e6e8ed;text-align:right;">Success</th>
                <th style="padding:10px;border:1px solid #e6e8ed;text-align:right;">Success Rate</th>
              </tr>
            </thead>
            <tbody>${workflowRows}</tbody>
          </table>
        </div>
      </div>
    </body>
  </html>
  `;
}

function renderMetricCard(label, value) {
  return `
    <div style="flex:1 1 180px;min-width:170px;border:1px solid #dbe1ea;border-radius:10px;padding:12px 14px;background:#fafafa;">
      <div style="font-size:12px;font-weight:700;color:#8a94a6;margin-bottom:6px;">${escapeHtml(label)}</div>
      <div style="font-size:16px;font-weight:800;color:#182230;">${escapeHtml(String(value))}</div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPercent(value) {
  return `${Number(value).toFixed(2)}%`;
}

function formatDateTime(date, timezone) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDate(date, timezone) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatSubjectDate(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "long",
    day: "2-digit",
  })
    .format(date)
    .toUpperCase();
}

function getPreviousDayWindow(referenceDate, timezone) {
  const { year, month, day } = getZonedDateParts(referenceDate, timezone);
  const todayUtc = Date.UTC(year, month - 1, day);
  const previousDay = new Date(todayUtc - 24 * 60 * 60 * 1000);

  const previousDayYear = previousDay.getUTCFullYear();
  const previousDayMonth = previousDay.getUTCMonth() + 1;
  const previousDayDate = previousDay.getUTCDate();

  return {
    startTime: zonedDateTimeToUtc(timezone, previousDayYear, previousDayMonth, previousDayDate, 0, 0, 0, 0),
    endTime: zonedDateTimeToUtc(timezone, previousDayYear, previousDayMonth, previousDayDate, 23, 59, 59, 999),
  };
}

function getTrailingDayWindows(referenceStartTime, timezone, numberOfDays) {
  const windows = [];

  for (let offset = numberOfDays - 1; offset >= 0; offset -= 1) {
    const startTime = new Date(referenceStartTime.getTime() - offset * 24 * 60 * 60 * 1000);
    const parts = getZonedDateParts(startTime, timezone);

    windows.push({
      startTime: zonedDateTimeToUtc(timezone, parts.year, parts.month, parts.day, 0, 0, 0, 0),
      endTime: zonedDateTimeToUtc(timezone, parts.year, parts.month, parts.day, 23, 59, 59, 999),
      label: new Intl.DateTimeFormat("en-IN", {
        timeZone: timezone,
        month: "short",
        day: "2-digit",
      }).format(startTime),
    });
  }

  return windows;
}

function getZonedDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function zonedDateTimeToUtc(timezone, year, month, day, hour, minute, second, millisecond) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const firstOffset = getTimeZoneOffsetMs(utcGuess, timezone);
  let result = new Date(utcGuess.getTime() - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(result, timezone);

  if (secondOffset !== firstOffset) {
    result = new Date(utcGuess.getTime() - secondOffset);
  }

  return result;
}

function getTimeZoneOffsetMs(date, timezone) {
  const offsetText = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  const match = offsetText?.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    return 0;
  }

  const [, sign, hours, minutes = "00"] = match;
  const totalMinutes = Number(hours) * 60 + Number(minutes);
  const direction = sign === "+" ? 1 : -1;
  return direction * totalMinutes * 60 * 1000;
}
